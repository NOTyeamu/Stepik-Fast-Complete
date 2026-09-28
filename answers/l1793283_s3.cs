using System;

class Program
{
    static void Main()
    {
        long chislo = long.Parse(Console.ReadLine());

        if (chislo % 3 == 0)
        {
            Console.WriteLine("Делится на 3");
        }

        if (chislo % 5 == 0)
        {
            Console.WriteLine("Делится на 5");
        }

        if (chislo % 7 == 0)
        {
            Console.WriteLine("Делится на 7");
        }
    }
}