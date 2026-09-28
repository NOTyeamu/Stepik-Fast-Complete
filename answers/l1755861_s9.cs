using System;

class Program
{
    static void Main()
    {
        long income = long.Parse(Console.ReadLine());
        double rate = 0;

        if (income <= 10000)
        {
            rate = 0.0;
        }
        else if (income <= 50000)
        {
            rate = 0.13;
        }
        else if (income <= 100000)
        {
            rate = 0.20;
        }
        else
        {
            rate = 0.30;
        }

        long tax = (long)(income * rate);
        long netIncome = income - tax;

        Console.WriteLine($"Налог: {tax}");
        Console.WriteLine($"Доход: {netIncome}");
    }
}