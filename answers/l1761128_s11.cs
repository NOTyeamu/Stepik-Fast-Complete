using System;

class Program
{
    static void Main()
    {
        const double tax = 0.15;
        double income = double.Parse(Console.ReadLine());
        Console.WriteLine(income * tax);
    }
}