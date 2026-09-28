using System;

class Program
{
    static void Main()
    {
        int n = int.Parse(Console.ReadLine());
        int chislo = 1;

        while (chislo <= n)
        {
            Console.Write(chislo + " ");
            chislo = chislo * 2;
        }

        Console.WriteLine();
    }
}